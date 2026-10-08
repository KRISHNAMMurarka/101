import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createDeviceRuntime, createRouteGroupController, createEphemeralWebIdentity,
  RemoteResourcePublisher, RemoteResourceReceiver, authenticatedPeerScope,
  createApplicationSnapshot, restoreApplicationSnapshot, parseDeviceDescriptor } from '@101/connect';
import { createHostedApplication, hostedApplicationRequirements, HOSTED_APPLICATION_SOURCE_SHA256 } from '@101/hub-server/hosted-application';
import { connectAuthenticatedRelay } from '@101/hub-server/loopback-relay';

// This clock starts after static ESM imports, not at process/loader bootstrap.
const moduleBodyEnteredAt = performance.now();

/** Inert producer for this fixed fixture's three hosts. No effects or grants.
 * Clock identities select existing schema declarations only; they neither prove
 * native origin nor establish capture-clock mapping. The actual running host
 * supplies its separately approved native frame's observed identities. */
export function describeCrossHostGroup(hostId, frameClocks) {
  if (!['host-a', 'host-b', 'host-c'].includes(hostId)) throw Error('Fixed host declaration unavailable');
  const required = hostedApplicationRequirements(hostId, frameClocks);
  const frameDevice = parseDeviceDescriptor({ schemaVersion: 1, id: hostId + ':raster-source', label: 'Approved native raster', revision: 1,
    adapter: { id: 'example:cross-host-raster', version: '1.0.0' }, runtime: { platform: 'node-software' }, capabilities: [{ id: 'frame', semantic: 'example:native-raster', schemaVersion: 1,
      kind: 'sample', value: required.frameValue, permissions: ['subscribe'], delivery: { mode: 'latest', maxHz: 30, maxAgeMs: 250 } }] });
  const outputSinkDevice = { ...frameDevice, id: hostId + ':publication', capabilities: frameDevice.capabilities.map(value => ({ ...value, kind: 'property', permissions: ['write'], ownership: { mode: 'exclusive' } })) };
  const member = (id, from, to) => ({ id, required: true, from, to, startAfter: [], consent: { purpose: 'approved-local-host-group', sourceOwner: 'required', sinkOwner: 'required' },
    compensation: { prepared: 'release-grant', active: 'stop-route', physicalEffects: 'not-undone' }, safeState: { mode: 'provider-release' } });
  const contract = { schemaVersion: 1, id: 'example:host-group-' + hostId, members: [
    member('cursor-input', { deviceId: required.inputSource.id, capability: 'cursor', operation: 'subscribe' }, { deviceId: required.inputSink.id, capability: 'cursor', operation: 'invoke' }),
    member('raster-output', { deviceId: frameDevice.id, capability: 'frame', operation: 'subscribe' }, { deviceId: outputSinkDevice.id, capability: 'frame', operation: 'write' })],
    failure: { required: 'stop-all', optional: 'continue-degraded' }, recovery: { required: 'pause', optional: 'continue-degraded' } };
  return Object.freeze({ required, frameDevice, outputSinkDevice, contract, devices: Object.freeze([required.inputSource, required.inputSink, frameDevice, outputSinkDevice]) });
}

async function runRuntimeHost() {
// Fixed fixture program, inherited private IPC only. No selected executable,
// remote RPC listener, caller code, serialized grant or shared AbortSignal.
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const currentSignal = value => { try { return aborted.call(value) === false; } catch { return false; } };
const now = performance.now.bind(performance), encoder = new TextEncoder();
function startupMilestone(event, at = now()) {
  // The parent retains only these three fixed records and reports them on
  // unexpected failure. No identity, grant, path or application value leaves here.
  try { process.stderr.write(JSON.stringify({ kind: 'cross-host-startup', event, at }) + '\n'); } catch { /* Advisory only. */ }
}
startupMilestone('module-body-enter', moduleBodyEnteredAt);
const owner = new AbortController(), identity = await createEphemeralWebIdentity();
startupMilestone('identity-ready');
const requests = new Set(), sendWork = new Set(), clients = new Set(), opening = new Set(), tokens = new Map(), applyWork = new Set();
const nativePids = [];
let configuration, provider, epochHandle, authority, group, receiver, publisher, runtime, tick, latest,
  inputSource, inputConnection, outputSource, pendingIngress, commandOwner, inputOwner, frameOwner, outputOwner, deferred, closing, operations = 0,
  bytes = 0, attempts = 0, lastRequest = 0, localOperations = 0, nativeEffects = 0, releases = 0,
  rawIssued = 0, rawSettled = 0, peakRaw = 0, stageCalls = 0, nativeStarts = 0, groupStarts = 0,
  holdNext = false, releaseHeld;
const clock = 'cross-host-runtime:' + process.pid;
const applicationId = 'cross-host-raster';
const inputDevice = parseDeviceDescriptor({ schemaVersion: 1, id: 'shared-cursor-source', label: 'Owned software cursor', revision: 1,
  adapter: { id: 'example:cross-host-cursor', version: '1.0.0' }, runtime: { platform: 'node-software' }, capabilities: [{
    id: 'cursor', semantic: 'connect:hosted-cursor', schemaVersion: 1, kind: 'event',
    value: { type: 'record', fields: { x: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 }, y: { type: 'scalar', unit: '1', min: 0, max: 3, resolution: 1 } } },
    permissions: ['subscribe'], delivery: { mode: 'reliable', maxAgeMs: 250 } }] });
function stateValid(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === 'revision,x,y' &&
    Number.isInteger(value.x) && value.x >= 0 && value.x <= 3 && Number.isInteger(value.y) && value.y >= 0 && value.y <= 3 &&
    Number.isInteger(value.revision) && value.revision >= 0 && value.revision <= 32;
}
function ownedFile(directory, name) {
  if (!/^\/[^\0]*\/101-cross-host-[A-Za-z0-9]+\/(host-a|host-b|host-c)$/.test(directory)) throw Error('Host bootstrap directory invalid');
  if (realpathSync(directory) !== directory || (lstatSync(directory).mode & 0o777) !== 0o700) throw Error('Host bootstrap ownership invalid');
  const path = join(directory, name), stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || (stat.mode & 0o777) !== 0o600 || realpathSync(path) !== path) throw Error('Host bootstrap file invalid');
  return readFileSync(path, 'utf8');
}
function send(value) {
  const text = JSON.stringify(value), size = encoder.encode(text).byteLength;
  if (size > 4096 || bytes + size > 65536 || !process.connected || sendWork.size >= 1) return Promise.reject(Error('Host IPC unavailable'));
  bytes += size;
  let resolve, reject;
  const work = new Promise((yes, no) => { resolve = yes; reject = no; }); sendWork.add(work);
  try { process.send(value, error => { sendWork.delete(work); if (error) reject(error); else resolve(); }); }
  catch (error) { sendWork.delete(work); reject(error); }
  return work;
}
function localToken(number, active = false) {
  let selected = tokens.get(number);
  if (!selected) {
    if (tokens.size >= 8 || !Number.isSafeInteger(number) || number < 1) throw Error('Host epoch quota');
    const controller = new AbortController();
    selected = { controller, active, token: Object.freeze({ hostId: configuration.id, epoch: number, signal: controller.signal,
      isCurrent: () => authority === selected && selected.active && currentSignal(owner.signal) && currentSignal(controller.signal) }) };
    tokens.set(number, selected);
  }
  return selected;
}
function grantActive() { return currentSignal(owner.signal) && authority?.token.isCurrent() === true && currentSignal(inputOwner?.signal) && currentSignal(commandOwner?.signal) && now() < configuration.deadline; }
function frameActive() { return currentSignal(owner.signal) && authority?.token.isCurrent() === true && currentSignal(frameOwner?.signal) && currentSignal(outputOwner?.signal) && now() < configuration.deadline; }
async function retireData() {
  commandOwner?.abort(); inputOwner?.abort(); frameOwner?.abort(); outputOwner?.abort(); group?.stop('host-data-retired'); receiver?.stop(); publisher?.stop();
  runtime?.close(); if (tick) clearInterval(tick); tick = undefined; latest = undefined;
  releaseHeld?.(); releaseHeld = undefined;
  await Promise.allSettled([...opening]); const prior = [...clients]; clients.clear();
  await Promise.all(prior.map(value => value.stop()));
  if (deferred && !deferred.applyStarted) { deferred.finish(); deferred = undefined; }
  if (deferred) await deferred.done;
  await Promise.allSettled([...applyWork]);
  runtime = receiver = publisher = group = pendingIngress = undefined;
}
function rememberClient(promise) { opening.add(promise); void promise.then(value => {
  clients.add(value); if (!currentSignal(owner.signal)) void value.stop();
}, () => {}).finally(() => opening.delete(promise)); return promise; }
function trackApply(run) {
  if (applyWork.size >= 2) return Promise.reject(Error('Host apply quota'));
  let yes, no; const work = new Promise((resolve, reject) => { yes = resolve; no = reject; }); applyWork.add(work);
  Promise.resolve().then(run).then(yes, no);
  void work.then(() => applyWork.delete(work), () => applyWork.delete(work)); return work;
}
function approval(request) {
  if (!currentSignal(owner.signal) || !configuration || now() >= configuration.deadline || request.ownerId !== configuration.id ||
    request.providerId !== configuration.id || request.applicationId !== applicationId || request.sessionId !== configuration.sessionId ||
    request.codeSha256 !== HOSTED_APPLICATION_SOURCE_SHA256) return;
  // This fixed fixture owner independently selects exact native actions. These
  // approvals are local objects; no parent-provided grant is deserialized.
  if (request.action === 'input' && !grantActive() || request.action === 'frame' && !frameActive()) return;
  return { request, signal: request.action === 'input' ? commandOwner.signal : request.action === 'frame' ? frameOwner.signal : owner.signal, expiresAt: configuration.deadline };
}
async function openData(message) {
  await retireData(); if (!currentSignal(owner.signal) || !authority?.token.isCurrent()) throw Error('Host retired');
  commandOwner = new AbortController(); inputOwner = new AbortController(); frameOwner = new AbortController(); outputOwner = new AbortController();
  const certificatePem = ownedFile(configuration.directory, 'client.pem'), privateKeyPem = ownedFile(configuration.directory, 'client.key'), caCertificatePem = ownedFile(configuration.directory, 'ca.pem');
  const [input, output] = await Promise.all([message.input, message.output].map(credential => rememberClient(connectAuthenticatedRelay({
    credential, caCertificatePem, certificatePem, privateKeyPem, identity, signal: owner.signal }))));
  if (!currentSignal(owner.signal) || !authority.token.isCurrent()) throw Error('Host retired');
  const incoming = authenticatedPeerScope(input.peer), outgoing = authenticatedPeerScope(output.peer);
  if (!incoming || !outgoing || incoming.role !== 'receiver' || outgoing.role !== 'source' || incoming.epoch !== message.wireEpoch || outgoing.epoch !== message.wireEpoch ||
    incoming.applicationId !== applicationId || outgoing.applicationId !== applicationId || incoming.sessionId !== configuration.sessionId || outgoing.sessionId !== configuration.sessionId ||
    incoming.localKeyId !== identity.keyId || outgoing.localKeyId !== identity.keyId) throw Error('Host authenticated scope invalid');
  const initial = await provider.frame(epochHandle, { purpose: 'separately-approved-group-output', signal: frameOwner.signal });
  if (!initial.ok || !frameActive()) throw Error('Host native frame unavailable'); latest = initial.value;
  const { required, frameDevice, outputSinkDevice, contract, devices } = describeCrossHostGroup(configuration.id,
    { sourceClockId: latest.sourceTime.clockId, receiptClockId: latest.receiptClockId });
  const ingressDevice = { ...required.inputSink, id: configuration.id + ':ingress' };
  const references = new Map();
  runtime = createDeviceRuntime({ now, clockDomain: clock, maxRoutes: 4, maxRegistrations: 8, maxSubscribers: 2, maxPendingDeliveries: 2,
    authorize(request) {
      const active = request.sink.capabilityId === 'frame' ? frameActive() : grantActive();
      const admitted = references.get(request.sink.registrationId);
      if (!active || !admitted || request.principalId !== configuration.id || request.applicationId !== applicationId || request.sessionId !== configuration.sessionId ||
        request.sourceOperation !== 'subscribe' || request.sinkOperation !== admitted.operation || request.sink.deviceId !== admitted.device ||
        admitted.source && request.source.registrationId !== admitted.source || admitted.sourceDevice && request.source.deviceId !== admitted.sourceDevice) return;
      return { expiresAt: configuration.deadline, maxAgeMs: 250, maxHz: 30 };
    } });
  inputSource = runtime.registerSource({ device: required.inputSource, capability: 'cursor' });
  outputSource = runtime.registerSource({ device: frameDevice, capability: 'frame' });
  publisher = new RemoteResourcePublisher({ peer: output.peer, epoch: message.wireEpoch, clockId: clock, now, device: frameDevice, available: capability => capability === 'frame' && frameActive() });
  const nativeSink = runtime.registerSink({ device: required.inputSink, capability: 'cursor',
    apply(observation, context) { return trackApply(async () => {
      const work = deferred; if (!work) return;
      work.applyStarted = true;
      if (holdNext) { holdNext = false; await new Promise(resolve => { releaseHeld = resolve; }); releaseHeld = undefined; }
      if (!grantActive() || !context.isCurrent() || !currentSignal(context.signal) || !work.context.isCurrent() || !currentSignal(work.context.signal)) {
        work.finish(); if (deferred === work) deferred = undefined; return;
      }
      work.nativeStarted = true;
      rawIssued++; peakRaw = Math.max(peakRaw, 1); context.reportEvidence('dispatched');
      try {
        const result = await provider.input(epochHandle, observation.value, { purpose: 'separately-approved-native-input', signal: commandOwner.signal, context });
        if (result.ok && grantActive() && context.isCurrent() && currentSignal(context.signal) && work.context.isCurrent() && currentSignal(work.context.signal)) {
          context.reportEvidence('target-acknowledged'); work.context.reportEvidence('target-acknowledged'); nativeEffects++; work.result = result;
        } else work.result = result.ok ? { ok: false, reason: 'retired' } : result;
      } finally { rawSettled++; work.finish(); if (deferred === work) deferred = undefined; }
    }); }, release() { releases++; } });
  const publication = runtime.registerSink({ device: outputSinkDevice, capability: 'frame', apply(observation, context) {
    if (!frameActive() || !context.isCurrent() || !currentSignal(context.signal)) return;
    const admitted = publisher.publish('frame', observation.value, { capturedAt: observation.timestamp });
    if (admitted && frameActive() && context.isCurrent() && currentSignal(context.signal)) context.reportEvidence('dispatched');
  }, release() { releases++; latest = undefined; } });
  const ingress = runtime.registerSink({ device: ingressDevice, capability: 'cursor', apply(observation, context) { return trackApply(async () => {
    if (!grantActive() || !context.isCurrent() || !currentSignal(context.signal) || deferred || localOperations >= 16) return;
    let finish; const done = new Promise(resolve => { finish = resolve; });
    const work = { context, done, finish, result: undefined, nativeStarted: false, applyStarted: false }; deferred = work;
    const operationId = String(++localOperations), at = now();
    const offered = runtime.publish(inputSource, observation.value, { operationId, deadline: at + 250,
      timestamp: at, clockDomain: clock, provenance: { originalClock: observation.clockDomain, originalAt: observation.timestamp, bridge: 'retrieved-locally-not-capture-mapped' } });
    if (!offered.ok) { if (deferred === work) deferred = undefined; finish(); return; }
    runtime.flush();
    // A true provider acknowledgment, not publication/send/queue acceptance.
    await done;
  }); }, release() { releases++; } });
  references.set(nativeSink.id, { source: inputSource.id, device: required.inputSink.id, operation: 'invoke' });
  references.set(publication.id, { source: outputSource.id, device: outputSinkDevice.id, operation: 'write' });
  references.set(ingress.id, { device: ingressDevice.id, operation: 'invoke', sourceDevice: inputDevice.id });
  for (const endpoint of [inputSource, outputSource, nativeSink, publication, ingress]) runtime.setReadiness(endpoint, 'available');
  const routes = new Map();
  group = createRouteGroupController(contract, devices, entry => {
    const connection = runtime.route({ from: entry.id === 'cursor-input' ? inputSource : outputSource, to: entry.id === 'cursor-input' ? nativeSink : publication,
      principalId: configuration.id, applicationId, sessionId: configuration.sessionId, queueCapacity: 1, leaseMs: 1000 });
    routes.set(entry.id, connection); if (entry.id === 'cursor-input') inputConnection = connection; return connection;
  });
  const started = group.start(); if (!started.ok) throw Error('Host group start refused: ' + started.reason); groupStarts++;
  receiver = new RemoteResourceReceiver({ peer: input.peer, epoch: message.wireEpoch, clockId: clock, now, runtime, principalId: configuration.id, applicationId, sessionId: configuration.sessionId });
  tick = setInterval(() => {
    if (!currentSignal(owner.signal)) return;
    for (const route of routes.values()) if (route.status().state === 'active') route.renew(configuration.id);
    receiver.tick(); publisher.tick(); runtime.flush();
  }, 5);
  // Open only installs both owned listeners and real group members. The fixed
  // parent performs admit after its actual receiver listener exists; neither
  // one-time description can race ahead of a missing consumer.
  pendingIngress = { sink: ingress, device: ingressDevice };
  return { nativeStarts, groupStarts, group: group.status().state, descriptor: frameDevice, state: latest.state, scope: { epoch: incoming.epoch, localKeyId: incoming.localKeyId, gatewayKeyId: incoming.remoteKeyId } };
}
async function until(condition) {
  const deadline = now() + 2500; let turns = 0;
  while (!condition()) { if (!currentSignal(owner.signal) || ++turns > 500 || now() >= deadline) throw Error('Host effect deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
  if (!currentSignal(owner.signal)) throw Error('Host retired');
}
async function stop() {
  if (closing) return closing;
  owner.abort(); for (const selected of tokens.values()) selected.controller.abort();
  closing = (async () => { await retireData(); await provider?.close(); await Promise.allSettled([...requests]); await Promise.allSettled([...sendWork]); })();
  return closing;
}
async function dispatch(message) {
  if (!configuration) {
    if (message.kind !== 'init' || !['host-a', 'host-b', 'host-c'].includes(message.hostId) || typeof message.sessionId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(message.sessionId)) throw Error('Host initialization invalid');
    configuration = { id: message.hostId, directory: message.directory, sessionId: message.sessionId, deadline: now() + 9000, format: 1 };
    ownedFile(configuration.directory, 'ca.pem');
    provider = createHostedApplication({ ownerId: configuration.id, providerId: configuration.id, applicationId, sessionId: configuration.sessionId, signal: owner.signal,
      authorize: approval, onChild(observation) { nativeStarts++; if (nativeStarts > 3) throw Error('Native start quota'); nativePids.push(observation.pid); } });
    return { pid: process.pid, keyId: identity.keyId, codeSha256: HOSTED_APPLICATION_SOURCE_SHA256 };
  }
  if (!currentSignal(owner.signal) || now() >= configuration.deadline) throw Error('Host retired');
  if (message.kind === 'launch') { const result = await provider.start({ purpose: 'approved-cross-host-launch', version: 1 }); if (!result.ok) throw Error('Host launch refused'); epochHandle = result.value; return { nativeStarts }; }
  if (message.kind === 'format') { if (message.format !== 1 && message.format !== 2) throw Error('Host format invalid'); configuration.format = message.format; return { format: configuration.format }; }
  if (message.kind === 'stage') {
    const selected = localToken(message.epoch), required = hostedApplicationRequirements(configuration.id);
    const target = { ...required.workload, restart: { ...required.workload.restart, formatVersion: configuration.format } };
    const restored = await restoreApplicationSnapshot(target, required.context, message.capsule, [], stateValid);
    if (!currentSignal(owner.signal) || !currentSignal(selected.controller.signal)) throw Error('Host retired');
    if (!restored.ok) return { ok: false, reason: restored.reason, stageCalls, nativeStarts };
    await retireData(); authority = selected; selected.active = false;
    await provider.handoffHost().stage(restored.state, selected.token); epochHandle = provider.epoch(); stageCalls++;
    return { ok: true, stageCalls, nativeStarts };
  }
  if (message.kind === 'resume') {
    await retireData(); const selected = localToken(message.epoch); authority = selected; selected.active = true;
    await provider.handoffHost().resume(selected.token); epochHandle = provider.epoch(); return { nativeStarts, epoch: message.epoch };
  }
  if (message.kind === 'open') return openData(message);
  if (message.kind === 'admit') {
    if (!grantActive() || !frameActive() || !pendingIngress || !publisher.start()) throw Error('Host admission unavailable');
    const selected = pendingIngress; pendingIngress = undefined;
    await until(() => !!receiver.description());
    if (!receiver.approve({ capability: 'cursor', sink: selected.sink, sinkDevice: selected.device, sinkCapability: 'cursor', grant: { expiresAt: configuration.deadline, maxAgeMs: 250, maxHz: 30 }, leaseMs: 1000 })) throw Error('Host ingress refused');
    await until(() => receiver.status().active === 1 && receiver.status().clockReady);
    return { admitted: true, group: group.status().state };
  }
  if (message.kind === 'pause') {
    const selected = tokens.get(message.epoch); if (!selected || authority !== selected) throw Error('Host epoch invalid');
    selected.active = false; selected.controller.abort(); await retireData();
    const state = await provider.handoffHost().pause(selected.token, owner.signal);
    const required = hostedApplicationRequirements(configuration.id);
    return { capsule: createApplicationSnapshot(required.workload, required.context, state) };
  }
  if (message.kind === 'retire') { const selected = tokens.get(message.epoch); if (selected) { selected.active = false; selected.controller.abort(); }
    await retireData(); if (selected) await provider.handoffHost().stop(selected.token); return { retired: true }; }
  if (message.kind === 'sample') {
    if (!frameActive() || deferred) throw Error('Host frame busy');
    const result = await provider.frame(epochHandle, { purpose: 'separately-approved-native-frame', signal: frameOwner.signal });
    if (!result.ok || !frameActive()) throw Error('Host frame refused'); latest = result.value;
    const value = { pixels: latest.pixels, sequence: latest.sequence, providerEpoch: latest.providerEpoch, sourceTime: latest.sourceTime, quality: latest.quality, receivedAt: latest.receivedAt, receiptClockId: latest.receiptClockId };
    const at = now(), offered = runtime.publish(outputSource, value, { timestamp: at, clockDomain: clock,
      provenance: { nativeClock: latest.sourceTime.clockId, nativeAt: latest.sourceTime.at, mapping: 'unknown-native-capture' } });
    if (!offered.ok) throw Error('Host frame publication refused'); runtime.flush();
    return { state: latest.state, sequence: latest.sequence, digest: createHash('sha256').update(Uint8Array.from(latest.pixels)).digest('hex'), nativeEffects };
  }
  if (message.kind === 'deny-input') { if (message.owner === 'source') inputOwner?.abort(); else commandOwner?.abort(); group?.stop('explicit-owner-revoke'); return { effects: nativeEffects }; }
  if (message.kind === 'hold-next') { if (holdNext || releaseHeld || deferred) throw Error('Host gate busy'); holdNext = true; return { controlledSoftwareGate: true }; }
  if (message.kind === 'stats') return { pid: process.pid, nativeEffects, releases, rawIssued, rawSettled, peakRaw, pending: !!deferred, stageCalls, nativeStarts, groupStarts,
    group: group?.status().state, provider: provider.status(), operation: inputConnection?.operations().at(-1), operations, held: !!releaseHeld };
  throw Error('Host operation invalid');
}
process.on('message', message => {
  if (!message || Object.getPrototypeOf(message) !== Object.prototype || !Number.isSafeInteger(message.id) || message.id <= lastRequest || ++attempts > 64 || requests.size >= 2) { void stop(); return; }
  const size = encoder.encode(JSON.stringify(message)).byteLength; if (size > 4096 || bytes + size > 65536) { void stop(); return; } bytes += size; lastRequest = message.id;
  if (message.kind === 'close') {
    void stop().then(() => send({ id: message.id, ok: true, nativePids, value: { nativeEffects, releases, rawIssued, rawSettled, nativeStarts, cleanup: provider?.status().cleanupVerified ?? true } }))
      .finally(() => { process.disconnect(); }); return;
  }
  // One bounded next message can arrive before the previous reply's actual
  // native callback. It remains unissued until that prior work settles.
  const prior = [...requests];
  const work = Promise.allSettled(prior).then(() => dispatch(message)).then(value => send({ id: message.id, ok: true, nativePids, value }), () => send({ id: message.id, ok: false, reason: 'host-refused', phase: message.kind }));
  requests.add(work); void work.catch(() => stop()).finally(() => { operations++; requests.delete(work); });
});
process.on('disconnect', () => { void stop(); });
process.on('SIGTERM', () => { void stop().then(() => { if (process.connected) process.disconnect(); }); });
const lifetime = setTimeout(() => { void stop().then(() => { if (process.connected) process.disconnect(); }); }, 15000);
process.once('disconnect', () => { clearTimeout(lifetime); });
await send({ kind: 'hello', pid: process.pid, keyId: identity.keyId });
startupMilestone('hello-sent');

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (typeof process.send !== 'function') throw Error('Private inherited IPC required');
  await runRuntimeHost();
}
