import { authenticatedPeerScope, createDeviceRuntime, RemoteResourcePublisher, RemoteResourceReceiver,
  pointerSourceDescriptor, parseDeviceDescriptor, decodePacket } from '@101/connect';
import type { ResourcePeer, Connection, EndpointHandle, SignalValue } from '@101/connect';

export const WIRE_REPLAY_PROFILE = 'direct-wss-wire-replay/1';
export const WIRE_REPLAY_LIMITS = Object.freeze({ concurrentRuns: 1, routes: 3, registrations: 6, generations: 4, capturedFrames: 32,
  frameBytes: 4096, replayAttempts: 64, pendingNativeCallbacks: 8, nativeSockets: 128, nativeRunMs: 15000, checks: 32, receiptBytes: 16384 });
export type WireReplayKind = 'position' | 'contact' | 'counter' | 'bind';
export type WireReplayMutation = 'unchanged' | 'lower-sequence' | 'old-operation' | 'wrong-profile' | 'wrong-codec' | 'schema' | 'descriptor' |
  'old-connection' | 'old-epoch' | 'expired-capture' | 'expired-deadline' | 'late-sequence';
export type WireReplayScenario = 'baseline' | 'connection-recovery' | 'source-revoke' | 'sink-revoke';
export interface WireReplayBoundary {
  readonly path: 'direct-wss'; readonly scenario: WireReplayScenario;
  /** Fixed trusted native fixture. Capture/replay at actual socket.send only. */
  arm(kind: WireReplayKind): void;
  captured(kind: WireReplayKind): Readonly<{ sha256: string; bytes: number; codec: string; sequence?: number }> | undefined;
  replay(kind: WireReplayKind, mutation: WireReplayMutation): Promise<Readonly<{ admitted: true; unchanged: boolean; sha256: string; bytes: number }>>;
  revoke(role: 'source' | 'sink'): void;
  snapshot(): Readonly<{ nativeSockets: number; pendingNativeCallbacks: number; stopFrames: readonly Readonly<{ slot: number; reason: string }>[] }>;
  close(): Promise<void>;
}
export interface WireReplayOptions {
  sourcePeer: ResourcePeer; receiverPeer: ResourcePeer; epoch: string;
  sourceOwnerSignal: AbortSignal; sinkOwnerSignal: AbortSignal; signal: AbortSignal;
  now: () => number; boundary: WireReplayBoundary;
}
export interface WireReplayReceipt {
  result: 'pass'; profile: typeof WIRE_REPLAY_PROFILE; scenario: WireReplayScenario; checks: readonly string[];
  reliableEffects: readonly boolean[]; latestEffects: number; structuredEffects: number; releases: number;
  actualRealConnectionsRetired: number; unchangedNativeReplays: number; derivedEnvelopeAttempts: number;
  nativeFrameHashes: readonly string[];
  grantExpiry?: Readonly<{ deadlineAfterStartMs: number; lastConfirmedCurrentAfterStartMs: number; keepaliveTurns: number;
    retirements: readonly Readonly<{ afterStartMs: number; reason: 'expired' }>[] }>;
  cleanup: { routes: 0; heldContact: false; registrations: 0; ownedTimer: false };
  actualApplicationFrameReplay: true; tlsCiphertextReplay: false; physicalQualification: false;
}
const nativeAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const addEvent = EventTarget.prototype.addEventListener, removeEvent = EventTarget.prototype.removeEventListener;
let reserved = false;
function active(signal: unknown): signal is AbortSignal { try { return nativeAborted.call(signal) === false; } catch { return false; } }
function closed(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== fields.length) throw Error('Wire replay options invalid.');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of fields) { const property = Object.getOwnPropertyDescriptor(input, key); if (!property?.enumerable || !('value' in property)) throw Error('Wire replay options invalid.'); result[key] = property.value; }
  if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !fields.includes(key))) throw Error('Wire replay options invalid.'); return result;
}

/** Caller-owned, cooperative host approvals remain independent of authentication.
 * Native incoming frames reach the existing public receiver without bypassing it.
 * This selected software suite qualifies neither ciphertext replay nor other transports. */
export async function runWireReplayQualification(options: WireReplayOptions): Promise<WireReplayReceipt> {
  if (reserved) throw Error('Wire replay runner already active.'); reserved = true;
  let ownsPair = false, closedPair = false, timer: ReturnType<typeof setInterval> | undefined;
  let receiver: RemoteResourceReceiver | undefined, publisher: RemoteResourcePublisher | undefined, runtime: ReturnType<typeof createDeviceRuntime> | undefined;
  const local = new AbortController(), routes: Connection[] = [], handles = new Map<string, EndpointHandle>(), sourceRegistrations = new Map<string, string>();
  const retirements = new Map<string, { at: number; reason: string }>(); let grantExpiry: WireReplayReceipt['grantExpiry'];
  const checks: string[] = [], effects: boolean[] = [], hashes: string[] = []; let contact = false, latest = 0, counter = 0, releases = 0, peerValues = 0;
  let sourceSelected = false, sinkSelected = false, expiresAt = Infinity, previousAt = -1, startedAt = 0, unchanged = 0, derived = 0, turns = 0;
  let detach = () => {};
  function time() { const at = options.now(); if (!Number.isFinite(at) || at < 0 || at < previousAt || at > Number.MAX_SAFE_INTEGER) throw Error('Wire replay clock invalid.'); previousAt = at; return at; }
  function scope() {
    const source = authenticatedPeerScope(options.sourcePeer), sink = authenticatedPeerScope(options.receiverPeer);
    return !!source && !!sink && source.epoch === options.epoch && sink.epoch === options.epoch && source.role === 'source' && sink.role === 'receiver' &&
      source.applicationId === 'wire-replay' && source.applicationId === sink.applicationId && source.sessionId === sink.sessionId &&
      source.localKeyId !== sink.localKeyId && source.localKeyId === sink.remoteKeyId && source.remoteKeyId === sink.localKeyId;
  }
  const owners = () => active(local.signal) && active(options.signal) && active(options.sourceOwnerSignal) && active(options.sinkOwnerSignal);
  function current(retiredOwners = false) { const at = time(), enrolled = scope();
    if (!active(local.signal) || !active(options.signal) || !enrolled || !retiredOwners && !owners() || at - startedAt >= 4000) throw Error('Wire replay trial retired.'); }
  const check = (value: boolean, label: string) => { if (!value || checks.length >= 32) throw Error('Wire replay assertion failed: ' + label); checks.push(label); };
  async function wait(ms = 20, retiredOwners = false) { await new Promise<void>(resolve => setTimeout(resolve, ms)); current(retiredOwners); }
  async function until(condition: () => boolean, retiredOwners = false) {
    const deadline = time() + 1500; while (!condition()) { if (++turns > 800 || time() >= deadline) throw Error('Wire replay effect deadline.'); await wait(5, retiredOwners); } current(retiredOwners);
  }
  function incumbents() { current(); if (receiver?.status().active !== 3 || routes.filter(connection => connection.status().state === 'active').length !== 3) throw Error('Wire replay incumbent routes retired.'); }
  function offer(kind: 'position' | 'contact' | 'counter', value: SignalValue, capture = true) {
    current(); if (capture) options.boundary.arm(kind); const at = time(); if (!owners()) throw Error('Wire replay owner retired.');
    if (!publisher!.publish(kind, value, { capturedAt: at })) throw Error('Wire replay valid producer admission failed.');
  }
  async function replay(kind: WireReplayKind, mutation: WireReplayMutation, retiredOwners = false) {
    const requireIncumbents = !retiredOwners && mutation !== 'late-sequence';
    current(retiredOwners); if (requireIncumbents) incumbents();
    const receipt = await options.boundary.replay(kind, mutation); current(retiredOwners); if (requireIncumbents) incumbents();
    if (receipt.admitted !== true || receipt.bytes < 39 || receipt.bytes > 4096 || !/^[0-9a-f]{64}$/.test(receipt.sha256)) throw Error('Wire native replay result invalid.');
    if (receipt.unchanged) unchanged++; else derived++; await wait(20, retiredOwners); if (requireIncumbents) incumbents();
  }
  try {
    const captured = closed(options, ['sourcePeer', 'receiverPeer', 'epoch', 'sourceOwnerSignal', 'sinkOwnerSignal', 'signal', 'now', 'boundary']);
    const fixture = closed(captured.boundary, ['path', 'scenario', 'arm', 'captured', 'replay', 'revoke', 'snapshot', 'close']);
    for (const key of ['arm', 'captured', 'replay', 'revoke', 'snapshot', 'close']) if (typeof fixture[key] !== 'function') throw Error('Wire replay boundary invalid.');
    if (fixture.path !== 'direct-wss' || !['baseline', 'connection-recovery', 'source-revoke', 'sink-revoke'].includes(fixture.scenario as string)) throw Error('Wire replay boundary invalid.');
    captured.boundary = Object.freeze(fixture); options = Object.freeze(captured) as unknown as WireReplayOptions;
    if (typeof options.now !== 'function' || !owners() || !scope()) throw Error('Wire replay needs actual current enrolled peers and native owner signals.');
    ownsPair = true; startedAt = time(); current(); expiresAt = startedAt + (options.boundary.scenario === 'baseline' ? 700 : 3000);
    const retire = () => { for (const route of routes) runtime?.revoke(route); }, cancelled = () => { local.abort(); retire(); publisher?.stop(); receiver?.stop(); runtime?.close(); void options.boundary.close().catch(() => {}); };
    addEvent.call(options.sourceOwnerSignal, 'abort', retire, { once: true }); addEvent.call(options.sinkOwnerSignal, 'abort', retire, { once: true }); addEvent.call(options.signal, 'abort', cancelled, { once: true });
    const detachData = options.receiverPeer.onData((lane, data) => { const packet = decodePacket(data, lane)?.packet; if (packet?.type === 'sample' || packet?.type === 'event') peerValues++; });
    detach = () => { detachData(); removeEvent.call(options.sourceOwnerSignal, 'abort', retire); removeEvent.call(options.sinkOwnerSignal, 'abort', retire); removeEvent.call(options.signal, 'abort', cancelled); };
    const pointer = pointerSourceDescriptor('owned-generated-software-wire');
    const source = parseDeviceDescriptor({ ...pointer, id: 'owned-wire-source', label: 'Owned software replay source', capabilities: [
      ...pointer.capabilities.map(capability => ({ ...capability, delivery: capability.delivery.mode === 'latest' ? { mode: 'latest', maxHz: 60, maxAgeMs: 100 } : { mode: 'reliable', maxAgeMs: 100 } })),
      { id: 'counter', semantic: 'software:counter', schemaVersion: 1, kind: 'sample', value: { type: 'record', fields: { count: { type: 'scalar', unit: '1', min: 0, max: 64 } } },
        delivery: { mode: 'latest', maxHz: 60, maxAgeMs: 100 }, permissions: ['read', 'subscribe'] } ] });
    const sink = parseDeviceDescriptor({ ...source, id: 'owned-wire-target', capabilities: source.capabilities.map(capability => ({ ...capability,
      kind: capability.id === 'contact' ? 'command' : 'property', permissions: [capability.id === 'contact' ? 'invoke' : 'write'], ownership: { mode: 'exclusive' } })) });
    const enrolled = authenticatedPeerScope(options.receiverPeer)!;
    runtime = createDeviceRuntime({ now: time, clockDomain: 'wire-target-performance', maxRoutes: 3, maxSubscribers: 3, maxRegistrations: 6, maxPendingDeliveries: 3,
      authorize(request) { const at = time();
        if (!sourceSelected || !sinkSelected || !owners() || at >= expiresAt || request.principalId !== sink.id || request.applicationId !== enrolled.applicationId || request.sessionId !== enrolled.sessionId ||
          request.source.deviceId !== source.id || request.source.registrationId !== sourceRegistrations.get(request.source.capabilityId) || request.source.descriptorRevision !== 1 || request.source.schemaVersion !== 1 ||
          request.sink.deviceId !== sink.id || request.sink.registrationId !== handles.get(request.sink.capabilityId)?.id || request.sink.descriptorRevision !== 1 || request.sink.schemaVersion !== 1 ||
          request.source.capabilityId !== request.sink.capabilityId || request.sourceOperation !== 'subscribe' || request.sinkOperation !== (request.sink.capabilityId === 'contact' ? 'invoke' : 'write')) return;
        return { expiresAt, maxAgeMs: 100, maxHz: 60 }; } });
    const route = runtime.route.bind(runtime); runtime.route = request => {
      if (routes.length >= 8) throw Error('Wire managed route attempts exhausted.');
      for (const [capability, handle] of handles) if (request.to === handle) sourceRegistrations.set(capability, request.from.id);
      const result = route(request); routes.push(result); result.onClose(reason => retirements.set(result.id, { at: time(), reason })); if (!owners()) runtime!.revoke(result); return result;
    };
    for (const capability of sink.capabilities) { const handle = runtime.registerSink({ device: sink, capability: capability.id,
      apply(observation, context) { const at = time(), observed = context.isCurrent();
        if (!observed || !owners() || !active(context.signal) || at >= expiresAt) return;
        if (observation.quality !== 'valid' || observation.source.registrationId !== sourceRegistrations.get(capability.id)) throw Error('Wire observation origin invalid.');
        if (capability.id === 'contact') { if (typeof observation.value !== 'boolean' || !context.operationId || effects.length >= 8) throw Error('Wire reliable command invalid.'); contact = observation.value; effects.push(contact); }
        else if (capability.id === 'position') latest++;
        else { if (!observation.value || typeof observation.value !== 'object' || Array.isArray(observation.value) || !('count' in observation.value)) throw Error('Wire structured sample invalid.'); counter++; }
      }, release() { if (capability.id === 'contact') contact = false; releases++; } }); handles.set(capability.id, handle); runtime.setReadiness(handle, 'available'); }
    receiver = new RemoteResourceReceiver({ peer: options.receiverPeer, epoch: options.epoch, runtime, clockId: 'wire-target-performance', now: time,
      principalId: sink.id, applicationId: enrolled.applicationId, sessionId: enrolled.sessionId });
    publisher = new RemoteResourcePublisher({ peer: options.sourcePeer, epoch: options.epoch, now: time, clockId: 'wire-source-performance', device: source,
      available: () => { const at = time(); return sourceSelected && at < expiresAt && owners(); } });
    if (!publisher.start()) throw Error('Wire producer description failed.');
    timer = setInterval(() => { try { receiver?.tick(); publisher?.tick(); } catch { cancelled(); } }, 5);
    await until(() => !!receiver!.description() && receiver!.status().clockReady);
    const approve = (id: string) => receiver!.approve({ capability: id, sink: handles.get(id)!, sinkDevice: sink, sinkCapability: id,
      codec: id === 'position' ? 'normalized-pointer/1' : id === 'contact' ? 'json/1' : 'json/2', leaseMs: 1000, grant: { expiresAt, maxAgeMs: 100, maxHz: 60 } });
    if (options.boundary.scenario === 'baseline') {
      sinkSelected = true; approve('position'); await until(() => receiver!.status().pending === 0); check(receiver.status().active === 0 && latest === 0, 'source owner denial has zero new resource effects');
      sourceSelected = true; sinkSelected = false; approve('position'); await until(() => receiver!.status().pending === 0); check(receiver.status().active === 0 && latest === 0, 'sink owner denial has zero new resource effects');
    }
    sourceSelected = sinkSelected = true; options.boundary.arm('bind');
    for (const capability of sink.capabilities) if (!approve(capability.id)) throw Error('Wire exact resource approval failed.');
    await until(() => receiver!.status().active === 3 && ['position', 'contact', 'counter'].every(id => publisher!.isBound(id)));
    offer('position', { x: 0.2, y: 0.8 }); await until(() => latest === 1 && !!options.boundary.captured('position'));
    offer('counter', { count: 1 }); await until(() => counter === 1 && !!options.boundary.captured('counter'));
    offer('contact', true, false); await until(() => contact); offer('contact', false); await until(() => !contact && effects.length === 2 && !!options.boundary.captured('contact'));
    check(effects[0] === true && effects[1] === false && latest === 1 && counter === 1, 'separate grants produce actual compact, JSON2 and both reliable true/false effects');
    for (const kind of ['position', 'counter', 'contact'] as const) { const capture = options.boundary.captured(kind); if (!capture || capture.bytes > 4096 || !/^[0-9a-f]{64}$/.test(capture.sha256)) throw Error('Actual native capture missing.'); hashes.push(capture.sha256); }
    if (options.boundary.scenario === 'baseline') {
      let before = latest; await replay('position', 'unchanged'); check(latest === before, 'unchanged actual native compact frame duplicate cannot apply twice');
      offer('position', { x: 0.3, y: 0.7 }); await until(() => latest === before + 1); before = latest; await replay('position', 'lower-sequence'); check(latest === before, 'derived lower compact sequence cannot roll back current state');
      offer('contact', true, false); await until(() => contact && effects.length === 3); offer('contact', false); await until(() => !contact && effects.length === 4);
      const reliableBefore = effects.length; await replay('contact', 'unchanged'); await replay('contact', 'old-operation'); check(effects.length === reliableBefore, 'unchanged event duplicate and derived fresh higher-sequence old operation cannot apply');
      offer('counter', { count: 2 }); await until(() => counter === 2);
      const counterBefore = counter; await replay('counter', 'unchanged'); check(counter === counterBefore, 'unchanged actual native JSON2 frame duplicate cannot apply twice');
      await replay('position', 'wrong-profile'); await replay('position', 'wrong-codec'); check(latest === before, 'derived compact revision and wrong negotiated codec cannot apply');
      await replay('bind', 'descriptor'); await replay('bind', 'schema'); const stops = options.boundary.snapshot().stopFrames;
      check(stops.some(stop => stop.slot === 125 && stop.reason === 'incompatible') && stops.some(stop => stop.slot === 126 && stop.reason === 'incompatible') && publisher.status().active === 3,
        'fresh unused slots reject derived descriptor and schema pins without disturbing incumbents');
      await wait(130); await replay('position', 'expired-capture'); await replay('contact', 'expired-deadline'); check(latest === before && effects.length === reliableBefore, 'fresh-sequence derived stale capture and elapsed event deadline cannot apply');
      offer('position', { x: 0.5, y: 0.5 }, false); offer('counter', { count: 3 }, false); offer('contact', false, false);
      await until(() => latest === before + 1 && counter === counterBefore + 1 && effects.length === reliableBefore + 1); before = latest;
      check(true, 'fresh real native valid effects confirm all three current routes after coherent rejection batches');
      incumbents(); const expiring = routes.filter(value => value.status().state === 'active');
      if (expiring.length !== 3 || expiring.some(connection => connection.limits()?.expiresAt !== expiresAt)) throw Error('Wire captured grant expiry invalid.');
      let lastCurrent = time(), keepaliveTurns = 0, nextKeepalive = lastCurrent + 80;
      while (time() < expiresAt) {
        if (++turns > 800) throw Error('Wire expiry observation quota.');
        let crossedDeadline = false;
        for (const connection of expiring) {
          const renewed = connection.renew(sink.id), limits = connection.limits(), after = time();
          if (after >= expiresAt) { crossedDeadline = true; break; }
          if (!renewed.ok || limits?.expiresAt !== expiresAt || connection.status().state !== 'active') throw Error('Wire expiry incumbent retired before deadline.');
        }
        if (crossedDeadline) break;
        incumbents(); const confirmed = time(); if (confirmed >= expiresAt) break; lastCurrent = confirmed;
        if (lastCurrent >= nextKeepalive && lastCurrent < expiresAt - 80) {
          if (++keepaliveTurns > 3) throw Error('Wire expiry keepalive quota.'); const observed = { latest, counter, reliable: effects.length };
          offer('position', { x: 0.5, y: 0.5 }, false); offer('counter', { count: 3 + keepaliveTurns }, false); offer('contact', false, false);
          await until(() => latest === observed.latest + 1 && counter === observed.counter + 1 && effects.length === observed.reliable + 1);
          incumbents(); nextKeepalive = time() + 80;
        }
        await wait(5);
      }
      if (lastCurrent >= expiresAt || expiresAt - lastCurrent > 20) throw Error('Wire immediate pre-expiry observation missing.');
      await until(() => receiver!.status().active === 0);
      const closed = expiring.map(connection => retirements.get(connection.id));
      if (closed.some(retired => !retired || retired.at < expiresAt || retired.reason !== 'expired')) throw Error('Wire expiry phase lacks actual grant-expired retirement.');
      grantExpiry = Object.freeze({ deadlineAfterStartMs: expiresAt - startedAt, lastConfirmedCurrentAfterStartMs: lastCurrent - startedAt, keepaliveTurns,
        retirements: Object.freeze(closed.map(retired => Object.freeze({ afterStartMs: retired!.at - startedAt, reason: 'expired' as const }))) });
      before = latest; await replay('position', 'late-sequence'); check(latest === before && releases >= 3, 'observed real grant-expired reasons and times precede fresh-sequence late bytes');
    } else if (options.boundary.scenario === 'connection-recovery') {
      const before = latest, received = peerValues; await replay('position', 'old-connection'); check(latest === before && peerValues === received, 'unchanged captured old connection-tag frame is dropped before authenticated resource data');
      await replay('position', 'old-epoch'); check(latest === before && peerValues === received + 1, 'derived current outer tag and fresh timing admit old inner epoch to public boundary but cannot apply');
      offer('position', { x: 0.4, y: 0.6 }); await until(() => latest === before + 1); check(true, 'fresh identities epoch and independent approvals recover actual current effects');
    } else {
      offer('contact', true); await until(() => contact && effects.length === 3); const before = latest, reliableBefore = effects.length;
      options.boundary.revoke(options.boundary.scenario === 'source-revoke' ? 'source' : 'sink');
      await until(() => receiver!.status().active === 0 && !contact, true);
      await replay('position', 'unchanged', true); await replay('contact', 'late-sequence', true);
      check(latest === before && effects.length === reliableBefore && releases >= 3 && routes.every(connection => connection.status().state === 'closed'),
        'owner signal explicitly revokes real routes; unchanged and derived fresh-sequence late native bytes have zero new effects');
    }
  } finally {
    clearInterval(timer); timer = undefined; detach(); local.abort(); publisher?.stop(); receiver?.stop(); runtime?.close();
    try { if (ownsPair) await options.boundary.close(); closedPair = true; } finally { if (closedPair) reserved = false; }
  }
  if (contact || routes.some(connection => connection.status().state !== 'closed')) throw Error('Wire real route cleanup incomplete.');
  const receipt: WireReplayReceipt = { result: 'pass', profile: WIRE_REPLAY_PROFILE, scenario: options.boundary.scenario, checks: Object.freeze(checks), reliableEffects: Object.freeze(effects),
    latestEffects: latest, structuredEffects: counter, releases, actualRealConnectionsRetired: routes.length, unchangedNativeReplays: unchanged, derivedEnvelopeAttempts: derived, nativeFrameHashes: Object.freeze(hashes),
    ...(grantExpiry === undefined ? {} : { grantExpiry }), cleanup: { routes: 0, heldContact: false, registrations: 0, ownedTimer: false },
    actualApplicationFrameReplay: true, tlsCiphertextReplay: false, physicalQualification: false };
  if (new TextEncoder().encode(JSON.stringify(receipt)).byteLength > 16384) throw Error('Wire receipt quota.'); return Object.freeze(receipt);
}
